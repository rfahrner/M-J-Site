Option Explicit

' Classic Outlook only. New Outlook for Windows does not support VBA.
'
' Text Group fallback messages are created by the site with a mailto: link.
' Outlook normally opens those from whichever account/profile is currently
' default. This module switches TextBetter messages to memPPW as soon as the
' compose inspector opens, and repeats the same check at send time as a safety
' backstop.

Private WithEvents TextBetterInspectors As Outlook.Inspectors
Private Const TARGET_ACCOUNT As String = "memPPW@dltransport.com"
Private Const TEXTBETTER_DOMAIN As String = "@textbetter.com"

Private Sub Application_Startup()
    Set TextBetterInspectors = Application.Inspectors
End Sub

Private Sub TextBetterInspectors_NewInspector(ByVal Inspector As Outlook.Inspector)
    On Error GoTo SafeExit

    If Not TypeOf Inspector.CurrentItem Is Outlook.MailItem Then Exit Sub

    Dim mail As Outlook.MailItem
    Set mail = Inspector.CurrentItem

    If IsTextBetterMail(mail) Then
        SetTextBetterSendAccount mail
    End If

SafeExit:
End Sub

Private Sub Application_ItemSend(ByVal Item As Object, Cancel As Boolean)
    On Error GoTo SafeExit

    If Not TypeOf Item Is Outlook.MailItem Then Exit Sub

    Dim mail As Outlook.MailItem
    Set mail = Item

    If IsTextBetterMail(mail) Then
        SetTextBetterSendAccount mail
    End If

SafeExit:
End Sub

Private Function IsTextBetterMail(ByVal mail As Outlook.MailItem) As Boolean
    On Error GoTo SafeExit

    ' mail.To is the most reliable check for mailto-created messages once the
    ' compose window is being opened.
    If InStr(1, mail.To, TEXTBETTER_DOMAIN, vbTextCompare) > 0 Then
        IsTextBetterMail = True
        Exit Function
    End If

    ' Also inspect Recipients in case Outlook has not yet rendered the To field.
    Dim recipient As Outlook.Recipient
    For Each recipient In mail.Recipients
        If InStr(1, recipient.Address, TEXTBETTER_DOMAIN, vbTextCompare) > 0 _
           Or InStr(1, recipient.Name, TEXTBETTER_DOMAIN, vbTextCompare) > 0 Then
            IsTextBetterMail = True
            Exit Function
        End If
    Next recipient

SafeExit:
End Function

Private Sub SetTextBetterSendAccount(ByVal mail As Outlook.MailItem)
    On Error GoTo SafeExit

    Dim acc As Outlook.Account
    For Each acc In Application.Session.Accounts
        If StrComp(acc.SmtpAddress, TARGET_ACCOUNT, vbTextCompare) = 0 Then
            Set mail.SendUsingAccount = acc
            Exit Sub
        End If
    Next acc

SafeExit:
End Sub
